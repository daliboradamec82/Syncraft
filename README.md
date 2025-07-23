Syncraft Backend Challenge: Buffered Mongo Increments

Context
At Syncraft, we use MongoDB as our primary database to store metadata about users, their actors, runs, scraped data, and more. A typical user document might contain fields like:

numberOfRuns (integer)

numberOfEvents (integer)

numberOfItemsScraped (integer)

lastItemScrapedAt (date)

As our platform scaled and scraping activity increased, some of these fields were being updated thousands of times per second across hundreds of servers, creating significant load on MongoDB.

To solve this, we introduced a buffering layer using Redis. Increments are temporarily stored in Redis and then flushed to MongoDB in batches every few seconds.

Your Task
Implement a simplified version of this mechanism, supporting only incrementing integer fields.

Your class should:

Accept a MongoDB collection, a Redis client, and a flush interval (e.g., 5000 ms).

Buffer all .increment() calls in Redis.

Every X seconds, flush all pending increments to MongoDB in one batch.

Support negative values.

Work safely even when multiple instances of the class are running (e.g., across servers) – only one should perform the flush at a time (via Redis lock).

Example
ts
Copy
Edit
const buffered = new BufferedMongoIncrements(usersCollection, redisClient, 5000);

await buffered.increment('userId1', 'numberOfRuns', 5);
await buffered.increment('userId1', 'numberOfEvents', 20);
await buffered.increment('userId1', 'numberOfEvents', -2);

// After flush, MongoDB will receive: { numberOfRuns: 5, numberOfEvents: 18 }
Environment Setup
Run docker-compose up to start MongoDB and Redis.

Run npm install to install dependencies.

Implement your solution in ./src/bufferedMongoIncrements.ts.

Run npm run test to verify correctness.

Tests are located in ./test/bufferedMongoIncrements.test.ts.

Submission
Once you're done:

Commit your solution.

Submit a pull request to the repository.

Let us know!
