import { CLIOptions } from '../types';

const SHORT_FLAGS: Record<string, string> = {
    '-nh': 'noHeader',
};

function camelCaseOption(opt: string): string {
      const parts = opt.split('-');
      let ccOpt = "";
      for(let i=0;i<parts.length;i++) {
          let part = parts[i].toLowerCase();
          if( i != 0 ) {
              part = part.substring(0,1).toUpperCase()+part.substring(1);
          }
          ccOpt += part;
      }
      return ccOpt;
}

function getOptions(args: string[]): CLIOptions {
    const options: CLIOptions = {};
    for(const arg of args) {
        if( arg.startsWith('--') ) {
            if( arg.includes('=') ) {
                // Split on the first '=' only so values that themselves contain
                // '=' (e.g. --description="x=y") are preserved intact.
                const eq = arg.indexOf('=');
                const name = arg.substring(2, eq);
                const value = arg.substring(eq + 1);
                options[camelCaseOption(name)] = value;
            }else{
                options[camelCaseOption(arg.substring(2))] = true;
            }
        } else if( SHORT_FLAGS[arg] ) {
            options[SHORT_FLAGS[arg]] = true;
        }
    }
    if( options.hasOwnProperty('dryRun') && options.dryRun ) {
        console.log('DRY RUN: all actions will be simulated');
    }
    return options;
}

function stripOptions(args: string[]): string[] {
    return args.filter(arg=>!arg.startsWith('--') && !SHORT_FLAGS[arg]);
}

// Options accepted by every command.
const GLOBAL_OPTIONS = ['verbose', 'noHeader'];

function kebabCaseOption(opt: string): string {
    return opt.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
}

// Returns the parsed option keys that are not recognized by the command.
function unknownOptions(o: CLIOptions, allowed: string[]): string[] {
    const known = new Set([...GLOBAL_OPTIONS, ...allowed]);
    return Object.keys(o).filter(key => !known.has(key));
}

// Rejects mistyped flags (e.g. --api-filer=x) that would otherwise be
// silently ignored. Exits with an error listing the unrecognized flags.
function enforceKnownOptions(o: CLIOptions, command: string, allowed: string[] = []): void {
    const unknown = unknownOptions(o, allowed);
    if (unknown.length > 0) {
        const flags = unknown.map(k => `--${kebabCaseOption(k)}`).join(', ');
        console.error(`Unknown option${unknown.length > 1 ? 's' : ''} for '${command}': ${flags}`);
        console.error(`Run 'cicd help' for usage.`);
        process.exit(1);
    }
}

export { getOptions, stripOptions, unknownOptions, enforceKnownOptions };
