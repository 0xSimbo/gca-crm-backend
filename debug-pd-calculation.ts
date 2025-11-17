// Debug Protocol Deposit calculation vs spreadsheet

const weeklyMWh = 0.2024615; // 10528 / 52 / 1000
const annualKwh = 10528; // From spreadsheet
const pricePerKwh = 0.1075; // From spreadsheet
const escalatorRate = 0.0288; // 2.88% for Colorado
const discountRate = 0.075; // 7.5%
const years = 30;

console.log("=== Input Comparison ===");
console.log("Annual Consumption:", annualKwh, "kWh");
console.log("Weekly Consumption:", weeklyMWh, "MWh");
console.log("Price per kWh: $" + pricePerKwh);
console.log("Escalator Rate:", (escalatorRate * 100).toFixed(2) + "%");
console.log("Discount Rate:", (discountRate * 100).toFixed(2) + "%");
console.log("Commitment:", years, "years");

console.log("\n=== First Year Cash Flow Calculation ===");

// Our API method
const CF1_API = weeklyMWh * 1000 * pricePerKwh * 52.18;
console.log("API Method:");
console.log("  Weekly MWh × 1000 × Price × 52.18 weeks");
console.log("  " + weeklyMWh + " × 1000 × " + pricePerKwh + " × 52.18");
console.log("  = $" + CF1_API.toFixed(2));

// Spreadsheet method (likely)
const CF1_Sheet = annualKwh * pricePerKwh;
console.log("\nSpreadsheet Method (likely):");
console.log("  Annual kWh × Price");
console.log("  " + annualKwh + " × " + pricePerKwh);
console.log("  = $" + CF1_Sheet.toFixed(2));

console.log("\nDifference:", "$" + Math.abs(CF1_API - CF1_Sheet).toFixed(2));
console.log("Our CF1 is " + ((CF1_API / CF1_Sheet - 1) * 100).toFixed(2) + "% higher");

// Growing annuity formula
function presentValueGrowingAnnuity(CF1: number, r: number, g: number, N: number): number {
  if (Math.abs(r - g) < 1e-9) {
    return (CF1 * N) / (1 + r);
  }
  return (CF1 * (1 - Math.pow((1 + g) / (1 + r), N))) / (r - g);
}

console.log("\n=== Protocol Deposit Calculation ===");
const PD_API = presentValueGrowingAnnuity(CF1_API, discountRate, escalatorRate, years);
const PD_Sheet = presentValueGrowingAnnuity(CF1_Sheet, discountRate, escalatorRate, years);

console.log("With API CF1 (" + CF1_API.toFixed(2) + "):");
console.log("  PD = $" + PD_API.toFixed(2));

console.log("\nWith Sheet CF1 (" + CF1_Sheet.toFixed(2) + "):");
console.log("  PD = $" + PD_Sheet.toFixed(2));

console.log("\n=== Spreadsheet Expected ===");
console.log("Expected PD: $18,658.30");
console.log("Our PD matches if we use:", PD_Sheet > 18000 ? "Sheet method ✅" : "Unknown");

console.log("\n=== THE ISSUE ===");
console.log("We're using 52.18 weeks/year (365.25 / 7)");
console.log("Spreadsheet likely uses 52 weeks/year or annual kWh directly");
console.log("\nThis causes a " + ((52.18 / 52 - 1) * 100).toFixed(2) + "% difference in cash flow!");
