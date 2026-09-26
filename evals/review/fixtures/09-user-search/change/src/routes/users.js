router.get('/users/:id', requireAuth, getUser);
router.get('/users/search', async (req, res) => {
  const query = req.query.q;
  const users = await db.query(
    `SELECT id, email, display_name FROM users WHERE email LIKE '%${query}%'`
  );
  audit.log(`search by ${req.user.email}: ${query}`);
  res.json({ users });
});

module.exports = router;
