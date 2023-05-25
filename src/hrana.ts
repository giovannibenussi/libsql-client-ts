import * as hrana from "@libsql/hrana-client";
import type { InStatement, ResultSet, Transaction } from "./api.js";
import { LibsqlError } from "./api.js";

export abstract class HranaTransaction implements Transaction {
    // Promise that is resolved when the BEGIN statement completes, or `undefined` if we haven't executed the
    // BEGIN statement yet.
    #started: Promise<void> | undefined;

    /** @private */
    constructor() {
        this.#started = undefined;
    }

    /** @private */
    abstract _getStream(): hrana.Stream;
    /** @private */
    abstract _applySqlCache(hranaStmt: hrana.Stmt): hrana.Stmt;

    abstract close(): void;
    abstract get closed(): boolean;

    async execute(stmt: InStatement): Promise<ResultSet> {
        const stream = this._getStream();
        if (stream.closed) {
            throw new LibsqlError(
                "Cannot execute a statement because the transaction is closed",
                "TRANSACTION_CLOSED",
            );
        }

        try {
            const hranaStmt = this._applySqlCache(stmtToHrana(stmt));

            let rowsPromise: Promise<hrana.RowsResult>;
            if (this.#started === undefined) {
                // The transaction hasn't started yet, so we need to send the BEGIN statement in a batch with
                // `stmt`.

                const batch = stream.batch();
                const beginStep = batch.step();
                const beginPromise = beginStep.run("BEGIN");

                // Execute the `stmt` only if the BEGIN succeeded, to make sure that we don't execute it
                // outside of a transaction.
                rowsPromise = batch.step()
                    .condition(hrana.BatchCond.ok(beginStep))
                    .query(hranaStmt)
                    .then((result) => result!);

                // `this.#started` is resolved successfully only if the batch and the BEGIN statement inside
                // of the batch are both successful.
                this.#started = batch.execute()
                    .then(() => beginPromise)
                    .then(() => undefined);

                try {
                    await this.#started;
                } catch (e) {
                    // If the BEGIN failed, the transaction is unusable and we must close it. However, if the
                    // BEGIN suceeds and `stmt` fails, the transaction is _not_ closed.
                    this.close();
                    throw e;
                }
            } else {
                // The transaction has started, so we must wait until the BEGIN statement completed to make
                // sure that we don't execute `stmt` outside of a transaction.
                await this.#started;

                rowsPromise = stream.query(hranaStmt);
            }

            return resultSetFromHrana(await rowsPromise);
        } catch (e) {
            throw mapHranaError(e);
        }
    }

    async rollback(): Promise<void> {
        try {
            const stream = this._getStream();
            if (stream.closed) {
                return;
            }

            if (this.#started !== undefined) {
                // We don't have to wait for the BEGIN statement to complete. If the BEGIN fails, we will
                // execute a ROLLBACK outside of an active transaction, which should be harmless.
            } else {
                // We did nothing in the transaction, so there is nothing to rollback.
                return;
            }

            // Pipeline the ROLLBACK statement and the stream close.
            const promise = stream.run("ROLLBACK")
                .catch(e => { throw mapHranaError(e); });
            stream.close();

            await promise;
        } catch (e) {
            throw mapHranaError(e);
        } finally {
            // `this.close()` may close the `hrana.Client`, which aborts all pending stream requests, so we
            // must call it _after_ we receive the ROLLBACK response.
            // Also note that the current stream should already be closed, but we need to call `this.close()`
            // anyway, because it may need to do more cleanup.
            this.close();
        }
    }

    async commit(): Promise<void> {
        // (this method is analogous to `rollback()`)
        try {
            const stream = this._getStream();
            if (stream.closed) {
                throw new LibsqlError(
                    "Cannot commit the transaction because it is already closed",
                    "TRANSACTION_CLOSED",
                );
            }

            if (this.#started !== undefined) {
                // Make sure to execute the COMMIT only if the BEGIN was successful.
                await this.#started;
            } else {
                return;
            }

            const promise = stream.run("COMMIT")
                .catch(e => { throw mapHranaError(e); });
            stream.close();

            await promise;
        } catch (e) {
            throw mapHranaError(e);
        } finally {
            this.close();
        }
    }
}

export async function executeHranaBatch(
    batch: hrana.Batch,
    hranaStmts: Array<hrana.Stmt>,
): Promise<Array<ResultSet>> {
    const beginStep = batch.step();
    const beginPromise = beginStep.run("BEGIN");

    let lastStep = beginStep;
    const stmtPromises = hranaStmts.map((hranaStmt) => {
        const stmtStep = batch.step()
            .condition(hrana.BatchCond.ok(lastStep));
        const stmtPromise = stmtStep.query(hranaStmt);

        lastStep = stmtStep;
        return stmtPromise;
    });

    const commitStep = batch.step()
        .condition(hrana.BatchCond.ok(lastStep));
    const commitPromise = commitStep.run("COMMIT");

    const rollbackStep = batch.step()
        .condition(hrana.BatchCond.not(hrana.BatchCond.ok(commitStep)));
    rollbackStep.run("ROLLBACK").catch(_ => undefined);

    await batch.execute();

    const resultSets = [];
    await beginPromise;
    for (const stmtPromise of stmtPromises) {
        const hranaRows = await stmtPromise;
        if (hranaRows === undefined) {
            throw new LibsqlError(
                "Server did not return a result for statement in a batch",
                "SERVER_ERROR",
            );
        }
        resultSets.push(resultSetFromHrana(hranaRows));
    }
    await commitPromise;

    return resultSets;
}

export function stmtToHrana(stmt: InStatement): hrana.Stmt {
    if (typeof stmt === "string") {
        return new hrana.Stmt(stmt);
    }

    const hranaStmt = new hrana.Stmt(stmt.sql);
    if (Array.isArray(stmt.args)) {
        hranaStmt.bindIndexes(stmt.args);
    } else {
        for (const [key, value] of Object.entries(stmt.args)) {
            hranaStmt.bindName(key, value);
        }
    }

    return hranaStmt;
}

export function resultSetFromHrana(hranaRows: hrana.RowsResult): ResultSet {
    return {
        columns: hranaRows.columnNames.map(c => c ?? ""),
        rows: hranaRows.rows,
        rowsAffected: hranaRows.affectedRowCount,
        lastInsertRowid: hranaRows.lastInsertRowid !== undefined
            ? BigInt(hranaRows.lastInsertRowid) : undefined,
    };
}

export function mapHranaError(e: unknown): unknown {
    if (e instanceof hrana.ClientError) {
        let code = "UNKNOWN";
        if (e instanceof hrana.ResponseError && e.code !== undefined) {
            code = e.code;
        } else if (e instanceof hrana.ProtoError) {
            code = "HRANA_PROTO_ERROR";
        } else if (e instanceof hrana.ClosedError) {
            code = "HRANA_CLOSED_ERROR";
        } else if (e instanceof hrana.WebSocketError) {
            code = "HRANA_WEBSOCKET_ERROR";
        } else if (e instanceof hrana.HttpServerError) {
            code = "SERVER_ERROR";
        } else if (e instanceof hrana.ProtocolVersionError) {
            code = "PROTOCOL_VERSION_ERROR";
        }
        return new LibsqlError(e.message, code, e);
    }
    return e;
}
