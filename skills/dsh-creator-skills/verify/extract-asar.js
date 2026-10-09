const fs=require('fs'),path=require('path');
const asarPath=process.argv[2], prefix=process.argv[3], dest=process.argv[4];
const fd=fs.openSync(asarPath,'r');
const b=Buffer.alloc(12); fs.readSync(fd,b,0,12,null);
const size=b.readUInt32LE(4);
const hb=Buffer.alloc(size); fs.readSync(fd,hb,0,size,8);
const header=JSON.parse(hb.slice(8,8+hb.readUInt32LE(4)).toString('utf8'));
const base=8+size;
let n=0;
function walk(node,p){
  for(const [name,e] of Object.entries(node.files||{})){
    const q=p+name;
    if(e.files) walk(e,q+'/');
    else if(q.startsWith(prefix)){
      const rel=q.slice(prefix.length);
      let data;
      if(e.unpacked){
        data=fs.readFileSync(path.join(asarPath+'.unpacked',q));
      } else {
        data=Buffer.alloc(e.size);
        if(e.size) fs.readSync(fd,data,0,e.size,base+parseInt(e.offset,10));
      }
      const out=path.join(dest,rel);
      fs.mkdirSync(path.dirname(out),{recursive:true});
      fs.writeFileSync(out,data); n++;
    }
  }
}
walk(header,'');
console.log('extracted',n,'files ->',dest);
