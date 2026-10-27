
require("dotenv").config();

const express = require("express");
const pool = require("./config/db")
const { createEmailService, sendEmail } = require("./utils/sendEmail");

const app = express();
app.use(express.json());

const authRoutes = require ("./routes/authRoutes");
app.use("/api/auth",authRoutes);


const authMiddleware = require("./middleware/authMiddleware");

app.get("/api/auth/profile", authMiddleware, (req, res) => {
  res.status(200).json({
    message: "Access granted",
    user: req.user,
  });
});


app.get("/api/db-check", async (req, res) => {
    try{
    const result = await pool.query(
         "SELECT current_database() AS database_name"
    );
    res.json({
        message:"Database connected successfully",
        database:result.rows[0].database_name,
    });

 }catch(error){
    console.error(error.message);

    res.status(500).json({
        message:"Database connection failed"
    });
 }

});


const PORT = process.env.PORT;

createEmailService()
  .then(() => {
    console.log("Email service initialized successfully");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Email service error:", error.message);
  });






