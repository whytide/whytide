declare function Button(props: { label: string }): null;
export const Page = () => (
  <main>
    <h1>Leads</h1>
    <Button label="Save changes" />
    <img alt="Avatar" src="/avatar.png" />
    <input placeholder="Search leads..." type="search" />
    <p>{"Hello"}</p>
  </main>
);
