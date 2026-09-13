import * as core from "@actions/core";
import { restore, post, execute } from "./lifecycle.js";
void execute(() => (core.getState("phase") === "post" ? post() : restore(true)));
