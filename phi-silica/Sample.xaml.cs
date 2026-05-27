using AIDevGallery.Sample.Utils;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Text;
using Microsoft.Windows.AI.Text.Experimental;
using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AIDevGallery.Sample;

internal sealed partial class Sample : Microsoft.UI.Xaml.Controls.Page
{
    private LanguageModel? _languageModel;
    private LanguageModelExperimental? _experimentalModel;
    private CancellationTokenSource? _cts;

    public Sample()
    {
        this.Unloaded += (s, e) => CleanUp();
        this.InitializeComponent();
    }

    protected override async void OnNavigatedTo(Microsoft.UI.Xaml.Navigation.NavigationEventArgs e)
    {
        // 1. Check if the model is ready on the device
        var readyState = LanguageModel.GetReadyState();
        if (readyState is AIFeatureReadyState.Ready or AIFeatureReadyState.NotReady)
        {
            if (readyState == AIFeatureReadyState.NotReady)
            {
                // 2. Install the model on the device
                var operation = await LanguageModel.EnsureReadyAsync();
                if (operation.Status != AIFeatureReadyResultState.Success)
                {
                    App.Window?.ShowException(null, $"Phi-Silica is not available");
                }
            }
        }
        else
        {
            var msg = readyState == AIFeatureReadyState.DisabledByUser
                ? "Disabled by user."
                : "Not supported on this system.";
            App.Window?.ShowException(null, $"Phi-Silica is not available: {msg}");
        }

        App.Window?.ModelLoaded();
    }

    private void CleanUp()
    {
        _cts?.Cancel();
        _experimentalModel?.Dispose();
        _languageModel?.Dispose();
    }

    private void Ticket_Tapped(object sender, TappedRoutedEventArgs e)
    {
        if (sender is Border border && border.Child is StackPanel stack)
        {
            var sb = new StringBuilder();
            foreach (var child in stack.Children)
            {
                if (child is TextBlock tb)
                {
                    sb.AppendLine(tb.Text);
                }
            }

            var orderDescription = sb.ToString().Trim();
            if (!string.IsNullOrEmpty(orderDescription))
            {
                _ = GenerateRecipe(orderDescription);
            }
        }
    }

    private async Task GenerateRecipe(string orderDescription)
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();

        RecipeTextBlock.Text = string.Empty;
        RecipeHeader.Text = "Recipe";
        RecipeProgressRing.Visibility = Visibility.Visible;

        // 3. Initialize the model and experimental wrapper
        _languageModel ??= await LanguageModel.CreateAsync();
        _experimentalModel ??= new LanguageModelExperimental(_languageModel);

        var prompt = $"Extract structured information from this drink order\n\n{orderDescription}";

        string jsonSchema = @"
{
    ""type"": ""object"",
    ""properties"": {
        ""drink_name"": { ""type"": ""string"" },   
        ""drink_type"": { ""type"": ""string"", ""enum"": [""coffee"", ""tea"", ""smoothie""] },
        ""size"": { ""type"": ""string"", ""enum"": [""small"", ""medium"", ""large""] },
        ""milk"": { ""type"": ""string"", ""enum"": [""whole"", ""oat"", ""skim"", ""almond"", ""soy""] },
        ""flavors"": {
            ""type"": ""array"",
            ""items"": { ""type"": ""string"" }
        },
        ""modifiers"": {
            ""type"": ""array"",
            ""items"": { ""type"": ""string"" }
        },
        ""quantity"": { ""type"": ""integer"" }
    },
    ""required"": [""drink_name"", ""drink_type"", ""size"", ""milk"", ""flavors"", ""modifiers"", ""quantity""]
}";

        var options = new LanguageModelOptionsExperimental();

        try
        {
            // 4. generate a response with the model
            var operation = _experimentalModel.GenerateStructuredJsonResponseAsync(
                prompt, jsonSchema, options);

            operation.Progress = (asyncInfo, delta) =>
            {
                DispatcherQueue.TryEnqueue(() =>
                {
                    RecipeProgressRing.Visibility = Visibility.Collapsed;
                    RecipeTextBlock.Text += delta;
                    if (_cts?.IsCancellationRequested == true)
                    {
                        operation.Cancel();
                    }
                });
            };

            var result = await operation;

            if (_cts == null || _cts.Token.IsCancellationRequested)
            {
                return;
            }

            if (result.Status == GenerateStructuredJsonResponseStatus.Complete)
            {
                RecipeTextBlock.Text = result.Text;
            }
            else
            {
                RecipeTextBlock.Text = $"Generation failed: {result.Status}";
            }
        }
        catch (Exception ex)
        {
            RecipeTextBlock.Text = $"Error: {ex.Message}";
        }

        RecipeProgressRing.Visibility = Visibility.Collapsed;
        _cts?.Dispose();
        _cts = null;
    }
}