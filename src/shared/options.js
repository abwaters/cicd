function camelCaseOption(opt) {
      const parts = opt.split('-');
      let ccOpt = "";
      for(let i=0;i<parts.length;i++) {
          let part = parts[i].toLowerCase();
          if( i != 0 ) {
              part = part.substr(0,1).toUpperCase()+part.substr(1);
          }
          ccOpt += part;
      }
      return ccOpt;
}

function getOptions(args) {
    const options = {};
    for(const arg of args) {
        if( arg.startsWith('--') ) {
            if( arg.includes('=') ) {
                let [name,value] = arg.substr(2).split('=');
                options[camelCaseOption(name)] = value;
            }else{
                options[camelCaseOption(arg.substr(2))] = true;
            }
        }
    }
    if( options.hasOwnProperty('dryRun') && options.dryRun ) {
        console.log('DRY RUN: all actions will be simulated');
    }
    return options;
}

function stripOptions(args) {
    return args.filter(arg=>!arg.startsWith('--'));
}

module.exports = {getOptions,stripOptions};