export function calculateReconstitution(vialMg:number, volumeMl:number, dose:number, doseUnit:string, capacityMl:number) {
  if (![vialMg,volumeMl,dose,capacityMl].every(n=>Number.isFinite(n)&&n>0)) throw new Error('Enter positive values for vial amount, liquid volume, target amount, and syringe size.')
  if (!['mg','mcg'].includes(doseUnit)) throw new Error('Choose mg or mcg.')
  if (![0.3,0.5,1].includes(capacityMl)) throw new Error('Choose a supported U-100 syringe size.')
  const doseMg=doseUnit==='mcg'?dose/1000:dose
  if (doseMg>vialMg) throw new Error('Target amount exceeds the total amount in the vial.')
  const concentration=vialMg/volumeMl, drawMl=doseMg/concentration, units=drawMl*100
  if (![concentration,drawMl,units,vialMg/doseMg].every(n=>Number.isFinite(n)&&n>0)) throw new Error('Values are outside the supported calculation range.')
  return {concentration,drawMl,units,doses:vialMg/doseMg,exceedsSyringe:drawMl>capacityMl}
}
