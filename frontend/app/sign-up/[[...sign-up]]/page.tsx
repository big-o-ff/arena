import { SignUp } from "@clerk/nextjs";
import TetrisLoading from "@/components/tetris-loader";

export default function SignUpPage() {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <SignUp
        fallback={<TetrisLoading size="md" speed="fast" loadingText="Opening secure channel..." />}
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "border border-noir-terminal bg-black",
          },
        }}
        forceRedirectUrl="/lobby"
        signInUrl="/sign-in"
      />
    </div>
  );
}
