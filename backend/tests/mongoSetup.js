const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Redis = require("ioredis");

let mongod;
let usesExternalMongo = false;

async function connect() {
    const externalUri = process.env.MONGO_URI_TEST || process.env.MONGO_URI;
    if (externalUri) {
        usesExternalMongo = true;
        await mongoose.connect(externalUri);
        return;
    }

    mongod = await MongoMemoryServer.create({
        instance: {
            ip: "127.0.0.1",
            port: 27027,
            dbName: "stibalert_test",
        },
    });
    const uri = mongod.getUri();
    process.env.MONGO_URI = uri;
    await mongoose.connect(uri);
}

async function disconnect() {
    await mongoose.disconnect();
    if (!usesExternalMongo && mongod) await mongod.stop();
}

async function clearAll() {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany({});
    }
    Redis._reset();
}

module.exports = { connect, disconnect, clearAll };
