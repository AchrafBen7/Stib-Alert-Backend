// In-memory Redis mock — used automatically by Jest for all tests.
// Supports the subset of ioredis API used by this application.

const _store = new Map();

class Redis {
    constructor() {
        this._store = _store;
    }

    async get(key) {
        const entry = this._store.get(key);
        if (!entry) return null;
        if (entry.expiry !== null && entry.expiry < Date.now()) {
            this._store.delete(key);
            return null;
        }
        return entry.value;
    }

    async set(key, value, exFlag, seconds) {
        const expiry = exFlag === "EX" && seconds ? Date.now() + seconds * 1000 : null;
        this._store.set(key, { value, expiry });
        return "OK";
    }

    async setex(key, seconds, value) {
        this._store.set(key, { value, expiry: Date.now() + seconds * 1000 });
        return "OK";
    }

    async del(key) {
        this._store.delete(key);
        return 1;
    }

    async flushall() {
        this._store.clear();
        return "OK";
    }

    on() {
        return this; // ignore event listener registration
    }

    // Test helper — clears the store between test suites
    static _reset() {
        _store.clear();
    }
}

module.exports = Redis;
