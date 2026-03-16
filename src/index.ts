import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import staffRoutes from './routes/staffRoutes';
import rolesRoutes from './routes/rolesRoutes';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/staff', staffRoutes);
app.use('/api/roles', rolesRoutes);

app.get('/', (req, res) => {
  res.send('FitFlow Custom Backend API is running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
