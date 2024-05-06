import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";
import fetch from "node-fetch"; // or any other fetch API you are using
import fs from "fs";

const fetchSchema = async () => {
  try {
    const response = await fetch("http://localhost:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });

    const { data, errors } = await response.json();

    if (errors) {
      console.error("Errors returned by the server:", JSON.stringify(errors));
      return;
    }

    const schema = buildClientSchema(data);
    const sdl = printSchema(schema);
    //sdl to graphql file
    fs.writeFileSync("schema.graphql", sdl);

    // Here you can use `data` to build your schema or save it to a file
  } catch (error) {
    console.error("Error fetching schema:", error);
  }
};

fetchSchema();
