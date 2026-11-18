const APP_KEY = /^[a-z][a-z0-9-]{1,62}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256 = /^[a-f0-9]{64}$/
const BLOCKED = new Set(['.git','node_modules','.env','data','uploads','storage','backups','customer-data','tenant-data'])
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
export function validateReleaseManifest(input: unknown) {
  const errors: Array<{code:string;path:string;message:string}> = []
  const add=(code:string,path:string,message:string)=>errors.push({code,path,message})
  if (!isRecord(input)) return {valid:false,errors:[{code:'invalid_manifest',path:'',message:'Manifest must be a JSON object.'}]}
  if (Object.keys(input).some(key=>!['schema_version','app_key','version','database_migration_version','files'].includes(key))) add('unknown_manifest_field','','Manifest contains unsupported fields.')
  if (input.schema_version!==1) add('unsupported_schema_version','schema_version','Only manifest schema version 1 is supported.')
  if (typeof input.app_key!=='string'||!APP_KEY.test(input.app_key)) add('invalid_app_key','app_key','Application key must be 2–63 lowercase letters, numbers or hyphens and start with a letter.')
  if (typeof input.version!=='string'||!SEMVER.test(input.version)) add('invalid_version','version','Version must use semantic versioning, for example 1.2.3.')
  if (!Number.isSafeInteger(input.database_migration_version)||Number(input.database_migration_version)<0) add('invalid_migration_version','database_migration_version','Database migration version must be a non-negative safe integer.')
  if (!Array.isArray(input.files)||input.files.length===0) add('invalid_files','files','Manifest must list at least one package file.')
  else {
    if(input.files.length>5000)add('too_many_files','files','Package may contain at most 5000 files.')
    const seen=new Set<string>();let total=0
    input.files.forEach((file,index)=>{
      const path='files['+index+']'
      if(!isRecord(file)){add('invalid_file_entry',path,'Each file entry must be a JSON object.');return}
      if(Object.keys(file).some(key=>!['path','sha256','size_bytes'].includes(key)))add('unknown_file_field',path,'File entry contains unsupported fields.')
      const name=file.path
      if(typeof name!=='string'||name.length===0||name.length>512||name.startsWith('/')||name.includes('\\')||/^[a-zA-Z]:/.test(name)||/[\u0000-\u001f\u007f]/.test(name)) add('unsafe_file_path',path+'.path','File path must be a safe relative POSIX path.')
      else {
        const parts=name.split('/')
        if(parts.some(part=>!part||part==='.'||part==='..'||BLOCKED.has(part.toLowerCase())||part.toLowerCase().startsWith('.env')))add('unsafe_file_path',path+'.path','File path targets traversal or a protected data/dependency directory.')
        if(seen.has(name))add('duplicate_file_path',path+'.path','Package file paths must be unique.')
        seen.add(name)
      }
      if(typeof file.sha256!=='string'||!SHA256.test(file.sha256))add('invalid_file_hash',path+'.sha256','File SHA-256 must be 64 lowercase hexadecimal characters.')
      if(!Number.isSafeInteger(file.size_bytes)||Number(file.size_bytes)<0||Number(file.size_bytes)>100*1024*1024)add('invalid_file_size',path+'.size_bytes','File size must be a non-negative safe integer no greater than 100 MB.')
      else total+=Number(file.size_bytes)
    })
    if(total>500*1024*1024)add('package_too_large','files','Total package size must not exceed 500 MB.')
  }
  if(errors.length)return {valid:false,errors}
  return {valid:true,manifest:input,total_bytes:(input.files as Array<{size_bytes:number}>).reduce((sum,file)=>sum+file.size_bytes,0)}
}
