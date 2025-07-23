import crypto from 'crypto';

import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import Redis from 'ioredis';

import { BufferedMongoIncrements } from '../src/bufferedMongoIncrements';

export const MONGODB_HOSTNAME = 'localhost'
export const MONGODB_PORT = 27017;

export const REDIS_HOSTNAME = 'localhost'
export const REDIS_PORT = 6379;

const MONGODB_URI = `mongodb://${MONGODB_HOSTNAME}:${MONGODB_PORT}`;

const randomHexString = () => crypto.randomBytes(5).toString('hex');

describe('BufferedMongoIncrements', () => {
    let mongoClient: MongoClient;
    let db: Db;
    let testedCollection: Collection;
    let redis: Redis;

    beforeAll(async () => {
        mongoClient = await MongoClient.connect(MONGODB_URI);
        redis = new Redis(REDIS_PORT, REDIS_HOSTNAME);
        db = mongoClient.db(`test-database-${randomHexString()}`);
    });

    beforeEach(async () => {
        const randomCollectionName = `test-users-${randomHexString()}`;
        testedCollection = db.collection(randomCollectionName);
    });

    afterEach(async () => {
        await testedCollection.drop();
        await redis.del('*');
    });

    afterAll(async () => {
        await db.dropDatabase();
        mongoClient.close();
        redis.disconnect();
    });

    it('works in a single instance', async () => {
        // Initialize collection
        const users = [
            { _id: 'user-1' as any },
            { _id: 'user-2' as any, stats: {} },
            { _id: 'user-3' as any, stats: { totalCU: 0 } },
            { _id: 'user-4' as any, stats: { totalCU: 111 } },
            { _id: 'user-5' as any, stats: { totalCU: -123 } },
        ];

        await testedCollection.insertMany(users);

        // Use BufferedMongoIncrements
        const flushIntervalMillis = 1000;
        const usersBufferedIncrements = new BufferedMongoIncrements(testedCollection, redis, flushIntervalMillis);

        try {
            // Prepare the value increments
            const increments = [0, 1, -10, 15, -2, 101, -19, 7, 5, 1];
            const incrementsSum = increments.reduce((prev, cur) => prev + cur, 0);

            // Wait half of the flushIntervalMillis to get in the middle of it
            await new Promise(resolve => setTimeout(resolve, 0.5 * flushIntervalMillis));

            // Check if the increments are working after each flush interval period
            for (const period of [1, 2, 3]) {
                // Increment users
                for (let increment of increments) {
                    await Promise.all(users.map((user) =>
                        usersBufferedIncrements.increment(user._id, 'stats.totalCU', increment),
                    ));
                }

                // Check that users are untouched before the flush
                for (const user of users) {
                    const userInDb = await testedCollection.findOne({ _id: user._id });
                    expect(userInDb.stats?.totalCU ?? 0).toBe((user.stats?.totalCU ?? 0) + (period - 1) * incrementsSum);
                }

                // Wait flushIntervalMillis and check that users got updated
                await new Promise(resolve => setTimeout(resolve, flushIntervalMillis));
                for (const user of users) {
                    const userInDb = await testedCollection.findOne({ _id: user._id });
                    expect(userInDb.stats?.totalCU ?? 0).toBe((user.stats?.totalCU ?? 0) + period * incrementsSum);
                }
            }
        } finally {
            // Clean up
            usersBufferedIncrements.destroy();
        }
    });

    it('flushes all increments at the same time', async () => {
        // Initialize collection
        const user = { _id: 'user-1' as any };
        const counters = ['counter1', 'counter2', 'counter3'];
        for (let i = 0; i < counters.length; i++) {
            user[counters[i]] = i;
        }
        await testedCollection.insertOne(user);

        // Use BufferedMongoIncrements
        const flushIntervalMillis = 1000;
        const usersBufferedIncrements = new BufferedMongoIncrements(testedCollection, redis, flushIntervalMillis);

        try {

            // Increment the counters on the user one by one with some delays,
            // so that after the final delay all increments are flushed
            const increment = 10
            for (const counter of counters) {
                await new Promise(resolve => setTimeout(resolve, flushIntervalMillis / (counters.length + 1)));
                usersBufferedIncrements.increment(user._id, counter, increment);
            }

            // Check that the increments were not flushed yet
            let userInDb = await testedCollection.findOne({ _id: user._id });
            for (const counter of counters) {
               expect(userInDb[counter]).toBe(user[counter]);
            }

            // Wait until just after the first flush interval finishes and check that all counters got updated at once
            await new Promise(resolve => setTimeout(resolve, flushIntervalMillis / (counters.length + 1)));
            userInDb = await testedCollection.findOne({ _id: user._id });
            for (const counter of counters) {
               expect(userInDb[counter]).toBe(user[counter] + increment);
            }
        } finally {
            // Clean up
            usersBufferedIncrements.destroy();
        }
    });

    it('works if multiple instances call increment concurrently', async () => {
        // Initialize collection
        const user = { _id: 'user-1' as any, counter: 0 };
        await testedCollection.insertOne(user);

        const flushIntervalMillis = 1000;

        // Create multiple incrementers, each with their interval start offset by a bit
        const usersBufferedIncrementsList = [];
        const incrementersCount = 20;
        for (let i = 0; i < incrementersCount; i++) {
            usersBufferedIncrementsList.push(new BufferedMongoIncrements(testedCollection, redis, flushIntervalMillis));
            await new Promise(resolve => setTimeout(resolve, flushIntervalMillis / incrementersCount));
        }

        try {
            // Make a record of how the values in the DB change over time
            const recordedCounter = [];

            // Check the db every flushIntervalMillis / incrementersCount milliseconds
            for (let period = 0; period < 5 * incrementersCount; period++) {
                // Increment the values through the buffer five times in total, once every flushIntervalMillis
                if (period % incrementersCount === 0) {
                    await Promise.all(usersBufferedIncrementsList.map(
                        (usersBufferedIncrements) => usersBufferedIncrements.increment(user._id, 'counter', 1),
                    ));
                }
                await new Promise(resolve => setTimeout(resolve, flushIntervalMillis / incrementersCount));

                // Record the current value in the database
                const userInDb = await testedCollection.findOne({ _id: user._id });
                recordedCounter.push(userInDb.counter);
            }

            // Testing these parallel time-dependent operations is tricky.
            // Ideally the array should start at `incrementersCount`,
            // and then increment by `incrementersCount` every `incrementersCount` values,
            // and then stay the same in between,
            // but we have to leave some leeway for delays, so we will do some fuzzy checking.
            // The array could be like [0, 20, 20, 20, ..., 20, 20, 28, 40, 40, ... 40, 60, 60, ... ], which is fine.
            // If the test fails too often, try decreasing `incrementersCount` or increasing `incrementPositionLeeway` to see if it helps.
            const incrementPositionLeeway = 4;
            for (let i = 0; i < 5 * incrementersCount; i++) {
                const actualValue = recordedCounter[i];
                // What the value should be in an ideal case
                const expectedValue = (Math.floor(i / incrementersCount) + 1) * incrementersCount;

                // Check if the value is within reason for that given position in the array
                if (i % incrementersCount >= incrementersCount - incrementPositionLeeway) {
                    // If it's the value just before an increment was expected, it could be already incremented
                    expect(actualValue).toBeGreaterThanOrEqual(expectedValue);
                    expect(actualValue).toBeLessThanOrEqual(expectedValue + incrementersCount);
                } else if (i % incrementersCount <= incrementPositionLeeway) {
                    // If it's the value just after the time when an increment was expected, it could be not incremented yet
                    expect(actualValue).toBeGreaterThanOrEqual(expectedValue - incrementersCount);
                    expect(actualValue).toBeLessThanOrEqual(expectedValue);
                } else {
                    // Values in the middle between increments must be accurate
                    expect(actualValue).toBe(expectedValue);
                }
            }

        } finally {
            usersBufferedIncrementsList.forEach((usersBufferedIncrements) => usersBufferedIncrements.destroy());
        }
    });
});
