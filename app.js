const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { initDB } = require('./config/database');
const { startCronEngine } = require('./services/cronService');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const queueRoutes = require('./routes/queues');
const jobRoutes = require('./routes/jobs');
const dashboardRoutes = require('./routes/dashboard');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/queues', queueRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/dashboard', dashboardRoutes);

const clientDistPath = path.resolve(__dirname, '../client/dist');
app.use(express.static(clientDistPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(errorHandler);

const startServer = async () => {
  try {
    await initDB();
    console.log('Database schema verified and loaded successfully.');

    startCronEngine();
    console.log('Cron scheduler active.');

    app.listen(PORT, () => {
      console.log(`QueueForge API listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
};

startServer();
