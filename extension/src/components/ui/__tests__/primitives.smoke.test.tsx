import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

function FormControlHarness() {
  const form = useForm<{ name: string }>({ defaultValues: { name: '' } })

  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl render={<input {...field} />} />
          </FormItem>
        )}
      />
    </Form>
  )
}

describe('ui primitives smoke', () => {
  it('opens Select, forwards positioning, and renders mapped labels', async () => {
    const user = userEvent.setup()
    render(
      <Select
        defaultValue="dark"
        items={{ dark: 'Dark mode', light: 'Light mode' }}
      >
        <SelectTrigger aria-label="Theme">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false}>
          <SelectGroup>
            <SelectItem value="dark">Dark mode</SelectItem>
            <SelectItem value="light">Light mode</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    )

    const trigger = screen.getByRole('combobox', { name: 'Theme' })
    expect(trigger.textContent).toContain('Dark mode')
    await user.click(trigger)

    const option = await screen.findByRole('option', { name: 'Light mode' })
    const popup = option.closest('[data-slot="select-content"]')
    await waitFor(() =>
      expect(popup?.parentElement?.getAttribute('data-align')).toBe('end')
    )

    await user.click(option)
    expect(trigger.textContent).toContain('Light mode')
  })

  it('opens DropdownMenu, forwards alignment, and invokes an item action', async () => {
    const user = userEvent.setup()
    const onPause = vi.fn()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button aria-label="Task actions" />}>
          Actions
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onPause}>Pause</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    await user.click(screen.getByRole('button', { name: 'Task actions' }))
    const item = await screen.findByRole('menuitem', { name: 'Pause' })
    const popup = item.closest('[data-slot="dropdown-menu-content"]')
    await waitFor(() =>
      expect(popup?.parentElement?.getAttribute('data-align')).toBe('end')
    )

    await user.click(item)
    expect(onPause).toHaveBeenCalledOnce()
  })

  it('merges FormControl accessibility props through render', () => {
    render(<FormControlHarness />)

    const input = screen.getByLabelText('Name')
    expect(input.getAttribute('data-slot')).toBe('form-control')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(input.getAttribute('aria-describedby')).not.toBeNull()
  })

  it('uses Base UI manual tab activation', async () => {
    const user = userEvent.setup()
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First panel</TabsContent>
        <TabsContent value="two">Second panel</TabsContent>
      </Tabs>
    )

    const first = screen.getByRole('tab', { name: 'One' })
    const second = screen.getByRole('tab', { name: 'Two' })
    first.focus()
    await user.keyboard('{ArrowRight}')

    expect(document.activeElement).toBe(second)
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(second.getAttribute('aria-selected')).toBe('false')

    await user.keyboard('{Enter}')
    expect(second.getAttribute('aria-selected')).toBe('true')
  })

  it('renders ScrollArea with the Base UI viewport', () => {
    const { container } = render(
      <ScrollArea className="h-20">
        <div>Scrollable content</div>
      </ScrollArea>
    )

    expect(screen.getByText('Scrollable content')).toBeTruthy()
    expect(
      container.querySelector('[data-slot="scroll-area-viewport"]')
    ).not.toBeNull()
    expect(container.querySelector('[data-slot="scroll-area"]')).not.toBeNull()
  })

  it('exposes Progress value through the Base UI primitive', () => {
    render(<Progress aria-label="Download progress" value={42} />)

    const progress = screen.getByRole('progressbar', {
      name: 'Download progress',
    })
    expect(progress.getAttribute('aria-valuenow')).toBe('42')
    expect(progress.getAttribute('data-progressing')).not.toBeNull()
    expect(
      progress.querySelector('[data-slot="progress-track"]')
    ).not.toBeNull()
  })

  it('renders Separator with semantic orientation', () => {
    render(<Separator orientation="vertical" />)

    const separator = screen.getByRole('separator')
    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.getAttribute('data-orientation')).toBe('vertical')
  })

  it('associates the native Label with its control', () => {
    render(
      <>
        <Label htmlFor="name">Name</Label>
        <input id="name" />
      </>
    )

    expect(screen.getByLabelText('Name').getAttribute('id')).toBe('name')
  })

  it('renders Badge through an anchor', () => {
    render(
      <Badge render={<a href="/status" />} variant="secondary">
        Connected
      </Badge>
    )

    const link = screen.getByRole('link', { name: 'Connected' })
    expect(link.getAttribute('href')).toBe('/status')
    expect(link.getAttribute('data-slot')).toBe('badge')
  })

  it('renders Button as a native button', () => {
    render(<Button variant="secondary">Save</Button>)

    const button = screen.getByRole('button', { name: 'Save' })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('data-slot')).toBe('button')
  })

  it('renders Switch as a switch role', () => {
    render(<Switch checked onCheckedChange={() => {}} />)

    const control = screen.getByRole('switch')
    expect(control.getAttribute('data-checked')).not.toBeNull()
    expect(control.getAttribute('data-state')).toBeNull()
  })

  it('renders Textarea', () => {
    render(<Textarea defaultValue="hi" aria-label="t" />)
    expect((screen.getByLabelText('t') as HTMLTextAreaElement).value).toBe('hi')
  })
})
