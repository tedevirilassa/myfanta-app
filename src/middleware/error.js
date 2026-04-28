
// src/middleware/error.js

function notFoundHandler(req, res, next) {
  res.status(404).json({
    ok: false,
    error: "Not Found",
    path: req.originalUrl,
  });
}

function errorHandler(err, req, res, next) {
  // Log base (in futuro potrai usare un logger più serio)
  console.error("Unhandled error:", err);

  const status = err.statusCode || err.status || 500;

  res.status(status).json({
    ok: false,
    error: status === 500 ? "Internal Server Error" : err.message,
  });
}

module.exports = { notFoundHandler, errorHandler };
``
