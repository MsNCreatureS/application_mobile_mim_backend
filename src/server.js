const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const equipementsRoutes = require('./routes/equipements');
const notificationsRoutes = require('./routes/notifications');
const ecartsRoutes = require('./routes/ecarts');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/equipements', equipementsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/ecarts', ecartsRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Serveur MIM Backend démarré sur le port ${PORT}`);
});
