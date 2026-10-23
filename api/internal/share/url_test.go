package share

import (
	"net/url"
	"testing"
)

func TestPublicURL(t *testing.T) {
	base, err := url.Parse("https://morsel.example:8443/")
	if err != nil {
		t.Fatal(err)
	}
	for _, preview := range []bool{false, true} {
		want := "https://morsel.example:8443/#/s/original-token"
		if preview {
			want = "https://morsel.example:8443/s/original-token"
		}
		if got := PublicURL(base, "original-token", preview); got != want {
			t.Fatalf("preview=%t: got %q, want %q", preview, got, want)
		}
	}
	if base.String() != "https://morsel.example:8443/" {
		t.Fatal("PublicURL mutated its base")
	}
}
