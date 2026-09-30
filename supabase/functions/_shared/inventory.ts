export type Stock={quantity:number;unit:string;low_threshold:number|null;package_amount:number|null;package_type:string|null;strength_amount:number|null;strength_unit:string|null;strength_per_amount:number|null;strength_per_unit:string|null}
export const stockNumber=(n:number)=>Number(n.toFixed(8))
export const displayStock=(n:number)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:4}).format(n)
export function doseInStockUnits(amount:number,unit:string,stock:Stock):number{
  if(!Number.isFinite(amount)||amount<=0)throw new Error('Enter a dose greater than zero.')
  const from=unit.toLowerCase(),to=stock.unit.toLowerCase()
  if(from===to)return stockNumber(amount)
  if(stock.strength_amount && stock.strength_per_amount && stock.strength_amount>0 && stock.strength_per_amount>0){
    const mass=stock.strength_unit?.toLowerCase(),volume=stock.strength_per_unit?.toLowerCase()
    if(from===mass && to===volume)return stockNumber(amount*stock.strength_per_amount/stock.strength_amount)
    if(from===volume && to===mass)return stockNumber(amount*stock.strength_amount/stock.strength_per_amount)
  }
  throw new Error('Add the total mg and mL in each package before logging a dose in a different unit.')
}
export function packageState(stock:Stock,doseAmount?:number|null,doseUnit?:string|null){
  const quantity=Math.max(0,Number(stock.quantity)),capacity=Number(stock.package_amount)
  if(!Number.isFinite(capacity)||capacity<=0)return null
  const equivalents=stockNumber(quantity/capacity),count=Math.ceil(equivalents)
  const current=count?stockNumber(quantity-(count-1)*capacity):0
  let deduction:number|null=null
  if(doseAmount && doseUnit){try{deduction=doseInStockUnits(Number(doseAmount),doseUnit,stock)}catch{}}
  return {count,equivalents,current,sealed:Math.max(0,count-1),percent:Math.min(100,Math.max(0,current/capacity*100)),deduction,doses:deduction?Math.floor(stockNumber(quantity/deduction)):null,dosesInCurrent:deduction?Math.floor(stockNumber(current/deduction)):null,changeSoon:!!deduction && quantity>current && current<deduction,lastDoseInPackage:!!deduction && current>=deduction && stockNumber(current-deduction)<deduction,low:stock.low_threshold!==null && quantity<=Number(stock.low_threshold),out:quantity===0 || (!!deduction && quantity<deduction)}
}
