import { Collection } from "mongodb";
import Redis from "ioredis";

export class BufferedMongoIncrements {
    private mongoCollection: Collection;
    private redisClient: Redis;
    private flushInterval: number;
    private bufferKey = "buffered_increments";
    private lockKey = "flush_lock";
    private intervalId: NodeJS.Timeout; // Uložíme interval pro jeho pozdější ukončení

    constructor(mongoCollection: Collection, redisClient: Redis, flushInterval: number) {
        this.mongoCollection = mongoCollection;
        this.redisClient = redisClient;
        this.flushInterval = flushInterval;

        // Uložíme interval ID, abychom ho mohli zastavit
        this.intervalId = setInterval(() => this.flushIfMaster(), this.flushInterval);
    }

    /** Inkrementace hodnoty v Redis */
    async increment(userId: string, field: string, value: number): Promise<void> {
        const key = `${userId}:${field}`;
        await this.redisClient.hincrby(this.bufferKey, key, value);
    }

    /** Flush bufferovaných změn do MongoDB */
    private async flushToMongoDB(): Promise<void> {
        const updates = await this.redisClient.hgetall(this.bufferKey);

        if (!updates || Object.keys(updates).length === 0) {
            return; // Nic k flushování
        }

        const bulkOperations = Object.entries(updates).map(([key, value]) => {
            const [userId, field] = key.split(":");
            return {
                updateOne: {
                    filter: { _id: userId },
                    update: { $inc: { [field]: parseInt(value, 10) } },
                },
            };
        });

        // Hromadně zapíšeme do MongoDB
        await this.mongoCollection.bulkWrite(bulkOperations);

        // Vymažeme buffer v Redis
        await this.redisClient.del(this.bufferKey);
    }

    /** Pokusí se provést flush, ale jen pokud získá zámek */
    private async flushIfMaster(): Promise<void> {
        const lockValue = Date.now().toString();

        // 1. Pokusíme se získat lock (na 5 sekund)
        const acquired = await this.redisClient.set(this.lockKey, lockValue, "EX", 5, "NX");

        if (!acquired) {
            console.log("Jiná instance právě flushuje. Čekám...");
            return;
        }

        try {
            console.log("Získal jsem lock, flushuji...");

            // 🔹 Aktualizujeme klíč každou sekundu pomocí GETSET
            const interval = setInterval(async () => {
                const oldValue = await this.redisClient.getset(this.lockKey, Date.now().toString());
                if (oldValue !== lockValue) {
                    console.log("Ztratil jsem lock, přerušuji flush.");
                    clearInterval(interval);
                    return;
                }
                await this.redisClient.expire(this.lockKey, 5);
            }, 1000);

            await this.flushToMongoDB();

            // ✅ Po úspěšném flushování zrušíme interval
            clearInterval(interval);
        } finally {
            // 2. Po flushi lock odstraníme (jen pokud jsme ho stále vlastníkem)
            const currentValue = await this.redisClient.get(this.lockKey);
            if (currentValue === lockValue) {
                await this.redisClient.del(this.lockKey);
            }
        }
    }

    /** Zastaví `setInterval()` a uvolní prostředky */
    destroy(): void {
        clearInterval(this.intervalId); // Zastaví automatické flushování
        console.log("BufferedMongoIncrements: interval zastaven.");
    }
}
