export function convertKWhToMWh(kWh: string | undefined) {
  if (!kWh) {
    return "";
  }
  const mWh = parseFloat(kWh) / 1000;
  return mWh.toFixed(5);
}
