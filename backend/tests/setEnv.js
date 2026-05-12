// Sets environment variables before any module is loaded.
// Runs in the Jest worker process before the test framework is initialized.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-minimum-32-characters-long";
process.env.ACTIVATION_SECRET = "test-activation-secret-32-chars!!";
process.env.REDIS_URL = "redis://mock-test";
process.env.CORS_ORIGINS = "";
// Dummy OPENAI key required for OpenAI constructor, but blocks real calls via OPENAI_DISABLE_IN_TESTS flag.
process.env.OPENAI_API_KEY = "sk-test-not-real-key";
process.env.OPENAI_DISABLE_IN_TESTS = "true";
process.env.GOOGLE_API_KEY = "test-google-key-not-used-in-tests";
process.env.RESEND_API_KEY = "test-resend-key-not-used-in-tests";
process.env.RESEND_FROM_EMAIL = "noreply@test.com";
// MONGO_URI is set dynamically in each test file via MongoMemoryServer
