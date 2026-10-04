const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function sessionHours(session) {
  if (!session.checkInAt || !session.checkOutAt) return 0;
  return (new Date(session.checkOutAt) - new Date(session.checkInAt)) / 3600000;
}

router.get('/:employeeId/:year/:month', async (req, res) => {
  const { employeeId, year, month } = req.params;
  try {
    const employee = await prisma.employee.findUnique({ where: { id: Number(employeeId) } });
    if (!employee) return res.status(404).json({ error: 'Xodim topilmadi' });

    const start = new Date(Number(year), Number(month) - 1, 1);
    const end = new Date(Number(year), Number(month), 1);

    const schedule = await prisma.employeeShift.findMany({ where: { employeeId: Number(employeeId), date: { gte: start, lt: end } }, include: { shift: true } });
    const sessions = await prisma.shiftSession.findMany({ where: { employeeId: Number(employeeId), shiftDate: { gte: start, lt: end }, isExtra: false } });
    const sessionByDate = new Map(sessions.map(s => [s.shiftDate.toDateString(), s]));

    let totalHours = 0, daysAttended = 0, daysMissed = 0, lateMinutesTotal = 0;
    for (const s of schedule) {
      const session = sessionByDate.get(s.date.toDateString());
      if (session && session.checkInAt) {
        daysAttended++;
        totalHours += sessionHours(session);
        if (session.status === 'kech' && session.minutesDiff > 0) lateMinutesTotal += session.minutesDiff;
      } else daysMissed++;
    }

    // Qo'shimcha (extra) smenalar — alohida hisoblanadi, har doim soatlik stavka bo'yicha
    const extraSessions = await prisma.shiftSession.findMany({
      where: { employeeId: Number(employeeId), isExtra: true, checkInAt: { gte: start, lt: end }, checkOutAt: { not: null } },
    });
    let extraHours = 0;
    for (const s of extraSessions) extraHours += sessionHours(s);
    const extraPay = Math.round(extraHours * employee.hourlyRate);

    const shiftPay = employee.monthlySalary ? employee.monthlySalary : Math.round(totalHours * employee.hourlyRate);

    const adjustments = await prisma.bonusPenalty.findMany({ where: { employeeId: Number(employeeId), date: { gte: start, lt: end } } });
    const bonus = adjustments.filter(a => a.type === 'bonus').reduce((s, a) => s + a.amount, 0);
    const penalty = adjustments.filter(a => a.type === 'penalty').reduce((s, a) => s + a.amount, 0);
    const productDeduction = adjustments.filter(a => a.type === 'product_deduction').reduce((s, a) => s + a.amount, 0);

    res.json({
      employee: { id: employee.id, fullName: employee.fullName, position: employee.position },
      year: Number(year), month: Number(month),
      totalHours, daysAttended, daysMissed, totalScheduledDays: schedule.length, lateMinutesTotal,
      extraHours, extraPay,
      shiftPay, bonus, penalty, productDeduction,
      netSalary: shiftPay + extraPay + bonus - penalty - productDeduction,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

router.get('/company/:companyId/:year/:month', async (req, res) => {
  const { companyId, year, month } = req.params;
  try {
    const employees = await prisma.employee.findMany({ where: { companyId: Number(companyId), active: true } });
    const start = new Date(Number(year), Number(month) - 1, 1);
    const end = new Date(Number(year), Number(month), 1);
    const results = [];

    for (const emp of employees) {
      const schedule = await prisma.employeeShift.findMany({ where: { employeeId: emp.id, date: { gte: start, lt: end } }, include: { shift: true } });
      const sessions = await prisma.shiftSession.findMany({ where: { employeeId: emp.id, shiftDate: { gte: start, lt: end }, isExtra: false } });
      const sessionByDate = new Map(sessions.map(s => [s.shiftDate.toDateString(), s]));

      let totalHours = 0, daysAttended = 0, daysMissed = 0;
      for (const s of schedule) {
        const session = sessionByDate.get(s.date.toDateString());
        if (session && session.checkInAt) { daysAttended++; totalHours += sessionHours(session); }
        else daysMissed++;
      }

      const extraSessions = await prisma.shiftSession.findMany({ where: { employeeId: emp.id, isExtra: true, checkInAt: { gte: start, lt: end }, checkOutAt: { not: null } } });
      let extraHours = 0;
      for (const s of extraSessions) extraHours += sessionHours(s);
      const extraPay = Math.round(extraHours * emp.hourlyRate);

      const shiftPay = emp.monthlySalary ? emp.monthlySalary : Math.round(totalHours * emp.hourlyRate);
      const adjustments = await prisma.bonusPenalty.findMany({ where: { employeeId: emp.id, date: { gte: start, lt: end } } });
      const bonus = adjustments.filter(a => a.type === 'bonus').reduce((s, a) => s + a.amount, 0);
      const penalty = adjustments.filter(a => a.type === 'penalty').reduce((s, a) => s + a.amount, 0);
      const productDeduction = adjustments.filter(a => a.type === 'product_deduction').reduce((s, a) => s + a.amount, 0);

      results.push({
        employeeId: emp.id, fullName: emp.fullName, position: emp.position,
        totalHours, daysAttended, daysMissed, extraHours, extraPay, shiftPay, bonus, penalty, productDeduction,
        netSalary: shiftPay + extraPay + bonus - penalty - productDeduction,
      });
    }
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

router.post('/adjustment', async (req, res) => {
  const { employeeId, type, amount, reason, date } = req.body;
  if (!employeeId || !type || amount == null) return res.status(400).json({ error: 'Xodim, tur va summa shart' });
  try {
    const adjustment = await prisma.bonusPenalty.create({ data: { employeeId: Number(employeeId), type, amount: Number(amount), reason: reason || null, date: date ? new Date(date) : new Date() } });
    res.json(adjustment);
  } catch (err) { res.status(500).json({ error: 'Server xatoligi' }); }
});

module.exports = router;
