import jwt from "jsonwebtoken";

export const jwtHandler = (token: string) => {
  const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!!);
  return decoded as { userId: string; iat: number; exp: number };
};
