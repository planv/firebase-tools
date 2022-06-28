/**
 * Copyright (c) 2022 Google LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import * as program from "commander";
import * as clc from "cli-color";
import * as leven from "leven";

import { logger } from "./logger";
import { setupLoggers } from "./utils";

const pkg = require("../package.json");

program.version(pkg.version);
program.option(
  "-P, --project <alias_or_project_id>",
  "the Firebase project to use for this command"
);
program.option("--account <email>", "the Google account to use for authorization");
program.option("-j, --json", "output JSON instead of text, also triggers non-interactive mode");
program.option("--token <token>", "supply an auth token for this command");
program.option("--non-interactive", "error out of the command instead of waiting for prompts");
program.option("-i, --interactive", "force prompts to be displayed");
program.option("--debug", "print verbose debug output and keep a debug log file");
program.option("-c, --config <path>", "path to the firebase.json file to use for configuration");

const client = {
  cli: program,
  logger: require("./logger"),
  errorOut: require("./errorOut").errorOut,
  getCommand: (name: string) => {
    for (let i = 0; i < client.cli.commands.length; i++) {
      if (client.cli.commands[i]._name === name) {
        return client.cli.commands[i];
      }
    }
    return;
  },
};

require("./commands").load(client);

/**
 * Checks to see if there is a different command similar to the provided one.
 * This prints the suggestion and returns it if there is one.
 * @param cmd The command as provided by the user.
 * @param cmdList List of commands available in the CLI.
 * @return Returns the suggested command; undefined if none.
 */
function suggestCommands(cmd: string, cmdList: string[]): string | undefined {
  const suggestion = cmdList.find((c) => {
    return leven(c, cmd) < c.length * 0.4;
  });
  if (suggestion) {
    logger.error();
    logger.error("Did you mean " + clc.bold(suggestion) + "?");
    return suggestion;
  }
}

const commandNames = program.commands.map((cmd: any) => {
  return cmd._name;
});

const RENAMED_COMMANDS: Record<string, string> = {
  "delete-site": "hosting:disable",
  "disable:hosting": "hosting:disable",
  "data:get": "database:get",
  "data:push": "database:push",
  "data:remove": "database:remove",
  "data:set": "database:set",
  "data:update": "database:update",
  "deploy:hosting": "deploy --only hosting",
  "deploy:database": "deploy --only database",
  "prefs:token": "login:ci",
};

// Default handler, this is called when no other command action matches.
program.action((_, args) => {
  setupLoggers();

  const cmd = args[0];
  logger.error(clc.bold.red("Error:"), clc.bold(cmd), "is not a Firebase command");

  if (RENAMED_COMMANDS[cmd]) {
    logger.error();
    logger.error(
      clc.bold(cmd) + " has been renamed, please run",
      clc.bold("firebase " + RENAMED_COMMANDS[cmd]),
      "instead"
    );
  } else {
    // Check if the first argument is close to a command.
    if (!suggestCommands(cmd, commandNames)) {
      // Check to see if combining the two arguments comes close to a command.
      // e.g. `firebase hosting disable` may suggest `hosting:disable`.
      suggestCommands(args.join(":"), commandNames);
    }
  }

  process.exit(1);
});

// NB: Keep this export line to keep firebase-tools-as-a-module working.
export = client;