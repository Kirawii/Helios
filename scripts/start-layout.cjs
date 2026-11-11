// Separate launch command: the ordinary start path keeps its existing default.
require('../load-env.cjs')();
process.env.HELIOS_LAYOUT='model';
const child=require('node:child_process').spawn(process.execPath,[require('node:path').join(__dirname,'../server.cjs')],{stdio:'inherit',windowsHide:true,env:process.env});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;});
