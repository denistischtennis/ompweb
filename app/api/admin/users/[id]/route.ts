import { adminGuard, deleteUser, getUser, patchUser } from "@/lib/users/admin-users";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return adminGuard(request) ?? getUser(request, (await context.params).id);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return adminGuard(request) ?? patchUser(request, (await context.params).id);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return adminGuard(request) ?? deleteUser(request, (await context.params).id);
}
