const { DATABASE_URL, PGHOST, PGDATABASE, PGUSER, PGPASSWORD } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}
if (!PGHOST) {
  throw new Error("PGHOST is not defined");
}
if (!PGDATABASE) {
  throw new Error("PGDATABASE is not defined");
}
if (!PGUSER) {
  throw new Error("PGUSER is not defined");
}
if (!PGPASSWORD) {
  throw new Error("PGPASSWORD is not defined");
}

export const PG_DATABASE_URL = DATABASE_URL;
export const PG_ENV = {
  host: PGHOST,
  database: PGDATABASE,
  user: PGUSER,
  port: 5432,
  password: PGPASSWORD,
};
