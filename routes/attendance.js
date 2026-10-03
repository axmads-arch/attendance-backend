const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function distanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findActiveOrUpcomingShift(employeeId, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  const candidates = await prisma.employeeShift.findMany({
    where: { employeeId, date: { in: [yesterday, today] } },
    include: { shift: true },
  });

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const c of candidates) {
    const [sh, sm] = c.shift.startTime.split(':').map(Number);
    const [eh, em] = c.shift.endTime.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const isYesterday = c.date.getTime() === yesterday.getTime();

    if (c.shift.crossesMidnight) {
      if (isYesterday && nowMinutes < endMin) return c;
      if (!isYesterday && nowMinutes >= startMin) return c;
    } else {
      if (!isYesterday) return c;
    }
  }
  return null;
}

function calcStatus(actualTime, scheduledTimeStr, shiftDate) {
  const [h, m] = scheduledTimeStr.split(':').map(Number);
  const scheduled = new Date(shiftDate);
  scheduled.setHours(h, m, 0, 0);
  const diffMinutes = Math.round((actualTime - scheduled) / 60000);
  const status = diffMinutes > 5 ? 'kech' : diffMinutes < -15 ? 'erta' : 'vaqtida';
  return { status, minutesDiff: diffMinutes };
}

router.post('/checkin', async (req, res) => {
  const { employeeId, photoUrl, latitude, longitude } = req.body;
  if (!employeeId || !photoUrl || latitude == null || longitude == null) {
    return res.status(400).json({ error: "Barcha maydonlar to'ldirilishi shart" });
  }
  try {
    const employee = await prisma.employee.findUnique({ where: { id: Number(employeeId) }, include: { company: true } });
    if (!employee) return res.status(404).json({ error: 'Xodim topilmadi' });

    const openSession = await prisma.shiftSession.findFirst({ where: { employeeId: employee.id, checkOutAt: null } });
    if (openSession) return res.status(400).json({ error: 'Siz allaqachon ishdasiz — avval chiqishni bosing' });

    const distance = distanceInMeters(latitude, longitude, employee.company.latitude, employee.company.longitude);
    if (distance > employee.company.radiusM) {
      return res.status(403).json({ error: `Siz ishxona hududida emassiz (${Math.round(distance)}m)`, distanceM: Math.round(distance) });
    }

    const now = new Date();
    const shiftRecord = await findActiveOrUpcomingShift(employee.id, now);

    let status = null, minutesDiff = null, shiftDate = now;
    if (shiftRecord) {
      shiftDate = shiftRecord.date;
      const result = calcStatus(now, shiftRecord.shift.startTime, shiftDate);
      status = result.status;
      minutesDiff = result.minutesDiff;
    }

    const session = await prisma.shiftSession.create({
      data: { employeeId: employee.id, shiftDate, checkInAt: now, checkInPhoto: photoUrl, status, minutesDiff, lastZone: 'inside' },
    });

    res.json({ success: true, session, status, minutesDiff });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

router.post('/checkout', async (req, res) => {
  const { employeeId, photoUrl, latitude, longitude } = req.body;
  try {
    const employee = await prisma.employee.findUnique({ where: { id: Number(employeeId) }, include: { company: true } });
    if (!employee) return res.status(404).json({ error: 'Xodim topilmadi' });

    const session = await prisma.shiftSession.findFirst({ where: { employeeId: employee.id, checkOutAt: null } });
    if (!session) return res.status(400).json({ error: 'Ochiq smena topilmadi — avval kirishni bosing' });

    const distance = distanceInMeters(latitude, longitude, employee.company.latitude, employee.company.longitude);
    if (distance > employee.company.radiusM) {
      return res.status(403).json({ error: `Siz ishxona hududida emassiz (${Math.round(distance)}m)`, distanceM: Math.round(distance) });
    }

    const updated = await prisma.shiftSession.update({
      where: { id: session.id },
      data: { checkOutAt: new Date(), checkOutPhoto: photoUrl },
    });

    res.json({ success: true, session: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

router.post('/ping', async (req, res) => {
  const { employeeId, latitude, longitude } = req.body;
  try {
    const employee = await prisma.employee.findUnique({ where: { id: Number(employeeId) }, include: { company: true } });
    if (!employee) return res.status(404).json({ error: 'Xodim topilmadi' });

    const session = await prisma.shiftSession.findFirst({ where: { employeeId: employee.id, checkOutAt: null } });
    if (!session) return res.json({ active: false });

    const distance = distanceInMeters(latitude, longitude, employee.company.latitude, employee.company.longitude);
    const nowInside = distance <= employee.company.radiusM;
    const wasInside = session.lastZone === 'inside';

    if (nowInside !== wasInside) {
      await prisma.zoneEvent.create({ data: { sessionId: session.id, type: nowInside ? 'enter' : 'exit', latitude, longitude } });
      await prisma.shiftSession.update({ where: { id: session.id }, data: { lastZone: nowInside ? 'inside' : 'outside' } });
    }

    res.json({ active: true, inside: nowInside });
  } catch (err) {
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

router.get('/status/:employeeId', async (req, res) => {
  try {
    const session = await prisma.shiftSession.findFirst({
      where: { employeeId: Number(req.params.employeeId), checkOutAt: null },
      include: { zoneEvents: { orderBy: { timestamp: 'asc' } } },
    });
    res.json({ onShift: !!session, session });
  } catch (err) {
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

router.get('/company/:companyId/day/:date', async (req, res) => {
  try {
    const date = new Date(req.params.date); date.setHours(0, 0, 0, 0);
    const nextDay = new Date(date); nextDay.setDate(nextDay.getDate() + 1);

    const employees = await prisma.employee.findMany({
      where: { companyId: Number(req.params.companyId), active: true },
      include: {
        sessions: {
          where: { shiftDate: { gte: date, lt: nextDay } },
          include: { zoneEvents: true },
          orderBy: { checkInAt: 'asc' },
        },
      },
    });
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

module.exports = router;
