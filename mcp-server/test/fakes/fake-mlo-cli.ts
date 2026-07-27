import { promises as fs } from "node:fs";
import { MloError, type MloExec } from "../../src/repo/mlo-cli.js";

/**
 * Simulated mlo.exe behind the driver's exec seam. Reproduces the two live CLI
 * traps (docs/mlo/mlo-cli.md) so driver tests can prove they never fire:
 *
 * 1. a pathless invocation against an open GUI forwards against the registry's
 *    (possibly stale) LastDBFile and silently no-ops with exit 0;
 * 2. any positional argument that is not the open file bypasses
 *    single-instance forwarding and launches a second MLO instance.
 *
 * Exit codes are scriptable via failNext().
 */
export class FakeMloCli {
  /** XML the "app" writes when a -saveXML target is given. */
  exportContent = '<?xml version="1.0"?><MyLifeOrganized-xml ver="1.2"><TaskTree><TaskNode Caption=""/></TaskTree></MyLifeOrganized-xml>';
  /** LastDBFile a pathless invocation routes against — stale after an in-app profile switch. */
  registryLastDbFile?: string;
  guiOpen = true;

  invocations: string[][] = [];
  silentNoOps = 0;
  secondInstances: string[] = [];
  quickSyncs = 0;

  private scriptedExits: number[] = [];

  constructor(
    /** The data file the running GUI has open. */
    readonly openDataFile: string
  ) {}

  failNext(exitCode: number): void {
    this.scriptedExits.push(exitCode);
  }

  readonly exec: MloExec = async (_exePath, args, _timeoutMs) => {
    this.invocations.push(args);
    const scripted = this.scriptedExits.shift();
    if (scripted) throw new MloError(`mlo.exe exited with code ${scripted}`, scripted);

    const positional = args.filter((a) => !a.startsWith("-"));
    const fileArg = positional[0];
    if (fileArg !== undefined && fileArg !== this.openDataFile) {
      // trap 2: exit 0 while a second instance pops "File not found" — nothing was forwarded
      this.secondInstances.push(fileArg);
      return;
    }
    if (positional.length > 1) {
      // a stray bare argument after the file (the missing-`=` slip with the
      // path present) is an invalid command line, not a silent success
      throw new MloError(`mlo.exe exited with code 1: invalid command-line argument "${positional[1]}"`, 1);
    }
    if (fileArg === undefined && this.guiOpen && this.registryLastDbFile !== this.openDataFile) {
      // trap 1: forwarded against the stale registry entry — silent no-op, exit 0
      this.silentNoOps++;
      return;
    }

    const saveXml = args.find((a) => a.startsWith("-saveXML="))?.slice("-saveXML=".length);
    if (saveXml !== undefined) await fs.writeFile(saveXml, this.exportContent, "utf8");
    if (args.includes("-QuickSync")) this.quickSyncs++;
  };
}
