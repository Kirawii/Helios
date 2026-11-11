const clientError=(message,status=400)=>Object.assign(Error(message),{status});
function sendHttpError(response,error){
  if(response.headersSent){response.destroy?.();return;}
  const supplied=Number(error.status??error.statusCode);
  const status=Number.isInteger(supplied)&&supplied>=400&&supplied<=599?supplied:error.code==='LIMIT_FILE_SIZE'?413:error.name==='MulterError'?400:500;
  if(status>=500)console.error(error);
  response.status(status).json({error:status>=500?'服务器内部错误':String(error.message||'请求失败')});
}
module.exports={clientError,sendHttpError};
