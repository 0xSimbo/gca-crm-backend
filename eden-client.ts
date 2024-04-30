import { edenTreaty } from "@elysiajs/eden";
import { ApiType } from "./lib/esm";

const apiClient = edenTreaty<ApiType>("http://localhost:3000");
async function main() {
  const response = await apiClient.typedBody.hello.post({
    age: 10,
    name: "Eden",
  });
  const data = response.data;
  if (!data) {
    throw new Error("No data");
  } else {
    const { age, name } = data;
    console.log(`Hello ${name}, you are ${age} years old`);
  }
}

main();
