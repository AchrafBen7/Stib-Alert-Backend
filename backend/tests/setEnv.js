// Sets environment variables before any module is loaded.
// Runs in the Jest worker process before the test framework is initialized.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-minimum-32-characters-long";
process.env.ACTIVATION_SECRET = "test-activation-secret-32-chars!!";
process.env.REDIS_URL = "redis://mock-test";
process.env.CORS_ORIGINS = "";
process.env.OPENAI_API_KEY = "test-openai-key-not-used-in-tests";
process.env.GOOGLE_API_KEY = "test-google-key-not-used-in-tests";
// MONGO_URI is set dynamically in each test file via MongoMemoryServer
