import { vi } from "vitest";

type Command = { readonly input: unknown };

// The AWS SDK clients type `send` with a callback overload that returns void, and `spyOn` picks it.
// A method type accepts the clients' own command classes, which a function property type does not.
interface Sender {
  readonly send: { bivarianceHack(command: Command): Promise<unknown> }["bivarianceHack"];
}

export function spyOnSend(client: Sender) {
  return vi.spyOn(client, "send");
}
