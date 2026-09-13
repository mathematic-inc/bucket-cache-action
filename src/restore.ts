import { restore, execute } from "./lifecycle.js";
void execute(() => restore(false));
