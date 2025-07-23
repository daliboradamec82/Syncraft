# Apify backend challenge

## Context

At Apify, we use MongoDB as our main database, and we use it to store the metadata about our users, their Actors and runs, the data they scraped, and many other things. For example, each document in MongoDB representing a user could have properties such as:

- `user.numberOfRuns` (integer)
- `user.numberOfEvents` (integer)
- `user.numberOfItemsScraped` (integer)
- `user.lastItemScrapedAt` (date)

As Apify grew, and users were scraping more and more data, these properties were updated more and more often, sometimes thousands of times per second from hundreds of servers, which would put a huge load on MongoDB. Therefore, a few years ago, we needed to start buffering these updates using a shared cache, and flush the updates to MongoDB just once every few seconds with the accumulated updates buffered in the cache.

## Task specification

The goal of this task is to implement a simplified version of this caching mechanism, supporting only incrementing of integer counters. In real life, there is a lot of additional complexity (supporting operations like `$set`, `$min`, `$max`, `$addToSet`, dealing with horizontal Redis scaling, ...) that you don't need to worry about right now.

Your task is to implement a class `BufferedMongoIncrements`, which will buffer the increments made to fields of documents in a given MongoDB collection in Redis, and flush all the buffered increments to all documents to MongoDB at once, only once every given interval:

```js
const usersBufferedIncrements = new BufferedMongoIncrements(
    mongodbClient.collection('users'),
    redisClient,
    5000, // Flush every 5 seconds
);

// ID of some user
const USER_ID = 'xxldnieojRj33DDijp';

// These updates are being buffered in Redis and every 5 seconds
// the BufferedMongoIncrements class will flush them to MongoDB.
await usersBufferedIncrements.increment(USER_ID, 'numberOfRuns', 5);
await usersBufferedIncrements.increment(USER_ID, 'numberOfEvents', 20);
await usersBufferedIncrements.increment(USER_ID, 'numberOfItemsScraped', 100);

// Class should support negative numbers
await usersBufferedIncrements.increment(USER_ID, 'numberOfEvents', -2);

// After 10 seconds the updates will be flushed
await sleep(10 * 1000);
const user = await mongodbClient.collection('users').findOne(USER_ID);
// `user` now contains this: {
//     numberOfRuns: 5,
//     numberOfEvents: 18,
//     numberOfItemsScraped: 100,
// }

```

Note that you can have multiple instances of the `BufferedMongoIncrements` class, either in the same process, or each running on a separate server, but sharing a common Redis and MongoDB. The flush to MongoDB should happen still only once per the specified period, and if separate instances of `BufferedMongoIncrements` try to flush the buffered updates to MongoDB at the same time, the flush should happen only once, and nothing should break.

## Prerequisites

The task is a Node.js & Typescript project, using Docker to provide the MongoDB and Redis instances needed for testing. You'll therefore need Node.js and Docker installed to solve it.

## Solution process

1. start Docker and run `docker compose up` to spin up the MongoDB and Redis containers
2. run `npm install` to install the required dependencies
3. write your solution 👨‍💻
    - the code for the `BufferedMongoIncrements` class should go to `./src/bufferedMongoIncrements.ts`
4. run `npm run test` to validate the solution
    - the tests are located in `./test/bufferedMongoIncrements.test.ts` if you want to take a look at what is being tested
5. submit your solution as a PR to the GitHub repository, and let us know
