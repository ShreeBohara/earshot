import { InMemoryEventStore } from "../src";
import { describeEventStoreContract } from "../src/testing";

// The store behavior tests live in the contract, so the Postgres store in @earshot/db runs the
// same ones against PGlite.
describeEventStoreContract("InMemoryEventStore", () => new InMemoryEventStore());
