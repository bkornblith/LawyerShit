import FormFill from "@/components/forms/FormFill";

export const metadata = { title: "Fill a form · Davis & Kwong" };

export default async function FillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FormFill id={id} />;
}
