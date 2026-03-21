import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <SignIn
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "border border-noir-terminal bg-black",
          },
        }}
        forceRedirectUrl="/lobby"
        signUpUrl="/sign-up"
      />
    </div>
  );
}
