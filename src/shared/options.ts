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
                let [name,value] = arg.substring(2).split('=');
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

module.exports = {getOptions,stripOptions};
