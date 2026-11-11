const fs=require('node:fs');
const path=require('node:path');

function loadEnv(filename=path.join(__dirname,'.env')){
  if(!fs.existsSync(filename))return;
  if(typeof process.loadEnvFile!=='function')throw Error('Reading .env requires Node.js 20.12 or newer');
  // Node preserves explicitly configured process environment variables.
  process.loadEnvFile(filename);
}

module.exports=loadEnv;
