import { adminGuard, createUser, listUsers } from "@/lib/users/admin-users";

export async function GET(request: Request): Promise<Response> {
  return adminGuard(request) ?? listUsers();
}

export async function POST(request: Request): Promise<Response> {
  return adminGuard(request) ?? createUser(request);
}
