import type { Prisma, PrismaClient } from "@prisma/client";

export type TransactionContext = Prisma.TransactionClient;

export interface TransactionRunner {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export class PrismaTransactionRunner implements TransactionRunner {
  constructor(private readonly client: Pick<PrismaClient, "$transaction">) {}

  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.client.$transaction(work);
  }
}
