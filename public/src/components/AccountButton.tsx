import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { LogIn, LogOut, User as UserIcon } from "lucide-react";

export const AccountButton = () => {
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return <div className="h-9 w-20 animate-pulse rounded-md surface-2" />;
  }

  if (!user) {
    return (
      <Button asChild size="sm" variant="secondary" className="gap-2">
        <Link to="/auth">
          <LogIn className="h-4 w-4" />
          Sign in
        </Link>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden max-w-[140px] items-center gap-1.5 truncate rounded-md surface-2 px-2.5 py-1.5 text-xs text-muted-foreground sm:flex">
        <UserIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{user.email}</span>
      </span>
      <Button size="sm" variant="ghost" className="gap-2" onClick={() => signOut()}>
        <LogOut className="h-4 w-4" />
        <span className="hidden sm:inline">Sign out</span>
      </Button>
    </div>
  );
};
