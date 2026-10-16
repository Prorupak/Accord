import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

// Global daily spend counter. One instance per environment ("global"), SQLite-backed (Workers Free).
// reserve() runs no awaits between read and write, so concurrent calls are serialized by the
// Durable Object's input gate: a reservation can never be granted twice. Units are never refunded.
export class Quota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, units INTEGER NOT NULL)");
  }

  reserve(day: string, units: number, limit: number): { granted: boolean; used: number } {
    const used = Number(this.ctx.storage.sql.exec("SELECT units FROM usage WHERE day = ?", day).toArray()[0]?.units ?? 0);
    if (used + units > limit) return { granted: false, used };
    this.ctx.storage.sql.exec(
      "INSERT INTO usage (day, units) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units",
      day,
      units,
    );
    return { granted: true, used: used + units };
  }

  used(day: string): number {
    return Number(this.ctx.storage.sql.exec("SELECT units FROM usage WHERE day = ?", day).toArray()[0]?.units ?? 0);
  }
}
