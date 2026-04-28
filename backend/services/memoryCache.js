const store = new Map();
const inFlight = new Map();

function get(key, { allowStale = false } = {}) {
	const entry = store.get(key);
	if (!entry) return null;

	const isExpired = entry.expiresAt <= Date.now();
	if (isExpired && !allowStale) {
		store.delete(key);
		return null;
	}

	return {
		value: entry.value,
		isExpired,
		createdAt: entry.createdAt,
		expiresAt: entry.expiresAt,
	};
}

function set(key, value, ttlMs) {
	const now = Date.now();
	store.set(key, {
		value,
		createdAt: now,
		expiresAt: now + Math.max(ttlMs, 0),
	});
	return value;
}

async function remember(key, ttlMs, factory, { staleOnError = true } = {}) {
	const fresh = get(key);
	if (fresh) return fresh.value;

	const pending = inFlight.get(key);
	if (pending) return pending;

	const stale = staleOnError ? get(key, { allowStale: true }) : null;

	const work = (async () => {
		try {
			const value = await factory();
			set(key, value, ttlMs);
			return value;
		} catch (error) {
			if (stale?.value !== undefined) {
				return stale.value;
			}
			throw error;
		} finally {
			inFlight.delete(key);
		}
	})();

	inFlight.set(key, work);
	return work;
}

module.exports = {
	get,
	set,
	remember,
};
