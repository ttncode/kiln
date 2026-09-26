router.get('/users/:id', requireAuth, getUser);

module.exports = router;
