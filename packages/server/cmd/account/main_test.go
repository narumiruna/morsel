package main

import (
	"testing"

	"github.com/google/uuid"
)

func TestGrantArguments(t *testing.T) {
	id := uuid.New()
	for _, test := range []struct {
		args  []string
		valid bool
		kind  string
		id    uuid.UUID
	}{
		{[]string{"-kind", "setup"}, true, "setup", uuid.Nil},
		{[]string{"-kind", "invite"}, true, "invite", uuid.Nil},
		{[]string{"-kind", "recover", "-account-id", id.String()}, true, "recover", id},
		{nil, false, "", uuid.Nil},
		{[]string{"-kind", "recover"}, false, "", uuid.Nil},
		{[]string{"-kind", "recover", "-account-id", uuid.Nil.String()}, false, "", uuid.Nil},
		{[]string{"-kind", "recover", "-account-id", "invalid"}, false, "", uuid.Nil},
		{[]string{"-kind", "setup", "-account-id", id.String()}, false, "", uuid.Nil},
		{[]string{"-kind", "invite", "-account-id", id.String()}, false, "", uuid.Nil},
		{[]string{"-kind", "invite", "extra"}, false, "", uuid.Nil},
		{[]string{"-kind", "unknown"}, false, "", uuid.Nil},
	} {
		kind, got, err := grantArguments(test.args)
		if (err == nil) != test.valid {
			t.Fatalf("args=%v err=%v", test.args, err)
		}
		if test.valid && (kind != test.kind || got != test.id) {
			t.Fatalf("args=%v kind=%s id=%s", test.args, kind, got)
		}
	}
}
