const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const digest = bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function readJSON(filename) {
  try {
    const {body,checksum}=JSON.parse(await fs.readFile(filename,'utf8'));
    if(typeof body!=='string'||digest(body)!==checksum)return;
    return JSON.parse(body);
  }catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return;throw error;}
}
async function writeBytes(filename,bytes) {
  await fs.mkdir(path.dirname(filename),{recursive:true});
  const temporary=filename+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,bytes);await fs.rename(temporary,filename);}
  catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
}
async function writeJSON(filename,data) {
  const body=JSON.stringify(data);await writeBytes(filename,JSON.stringify({body,checksum:digest(body)}));
}

class PreparationCache {
  constructor(directory,pdfHash,profile){this.directory=path.join(directory,pdfHash,profile);this.identity=pdfHash+':'+profile;}
  async readInfo(){const data=await readJSON(path.join(this.directory,'document.json'));if(Number.isSafeInteger(data?.pageCount)&&data.pageCount>0)return data;}
  writeInfo(data){return writeJSON(path.join(this.directory,'document.json'),data);}
  layoutFile(page){return path.join(this.directory,'layout-'+page+'.json');}
  regionIdentity(page,bounds,kind){return digest(JSON.stringify([this.identity,page,bounds,kind]));}
  async readLayout(page){const data=await readJSON(this.layoutFile(page));if(data?.page===page&&Array.isArray(data.blocks)&&Array.isArray(data.tasks))return data;}
  writeLayout(page,data){return writeJSON(this.layoutFile(page),data);}
  async readPage(page) {
    let bytes;try{bytes=await fs.readFile(path.join(this.directory,'page-'+page+'.crops'));}catch(error){if(error.code==='ENOENT')return new Map();throw error;}
    const images=new Map();
    if(bytes.length<12||bytes.subarray(0,8).toString()!=='OCRPAGE1')return images;
    const length=bytes.readUInt32BE(8);if(length>1024*1024||length+12>bytes.length)return images;
    let entries;try{entries=JSON.parse(bytes.subarray(12,12+length).toString());}catch{return images;}
    if(!Array.isArray(entries))return images;
    for(const entry of entries) {
      if(!entry||typeof entry.key!=='string'||!Number.isSafeInteger(entry.offset)||!Number.isSafeInteger(entry.length)||entry.offset<0||entry.length<24||12+length+entry.offset+entry.length>bytes.length)continue;
      const png=bytes.subarray(12+length+entry.offset,12+length+entry.offset+entry.length);
      if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||digest(png)!==entry.checksum||png.readUInt32BE(16)!==entry.width||png.readUInt32BE(20)!==entry.height)continue;
      images.set(entry.key,{width:entry.width,height:entry.height,png,...(entry.source?{source:entry.source}:{})});
    }
    return images;
  }
  async writePage(page,images) {
    const entries=[],parts=[];let offset=0;
    for(const [key,image] of images){entries.push({key,width:image.width,height:image.height,offset,length:image.png.length,checksum:digest(image.png),source:image.source});parts.push(image.png);offset+=image.png.length;}
    const header=Buffer.from(JSON.stringify(entries)),prefix=Buffer.alloc(12);prefix.write('OCRPAGE1');prefix.writeUInt32BE(header.length,8);
    await writeBytes(path.join(this.directory,'page-'+page+'.crops'),Buffer.concat([prefix,header,...parts]));
  }
  async hasLegacyImages(){try{return (await fs.stat(path.join(this.directory,'crops'))).isDirectory();}catch(error){if(error.code==='ENOENT')return false;throw error;}}
  async readImage(page,bounds,kind) {
    const key=this.regionIdentity(page,bounds,kind),filename=path.join(this.directory,'crops',key);
    const metadata=await readJSON(filename+'.json');if(!metadata)return;
    let png;try{png=await fs.readFile(filename+'.png');}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||digest(png)!==metadata.checksum||png.readUInt32BE(16)!==metadata.width||png.readUInt32BE(20)!==metadata.height)return;
    return {width:metadata.width,height:metadata.height,png,...(metadata.source?{source:metadata.source}:{})};
  }
  async writeImage(page,bounds,image,kind) {
    const filename=path.join(this.directory,'crops',this.regionIdentity(page,bounds,kind));
    await writeBytes(filename+'.png',image.png);
    await writeJSON(filename+'.json',{width:image.width,height:image.height,checksum:digest(image.png),source:image.source});
  }
}

module.exports={PreparationCache,digest};
